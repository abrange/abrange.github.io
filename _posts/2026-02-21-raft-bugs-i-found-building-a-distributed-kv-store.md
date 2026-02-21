---
layout: post
title: "4 Subtle Bugs I Found Building a Distributed Key-Value Store with RAFT"
date: 2026-02-21
categories: distributed-systems python
tags: [raft, consensus, distributed-systems, python, asyncio]
---

I recently built a distributed key-value store from scratch using the [RAFT consensus algorithm](https://raft.github.io/raft.pdf) in Python with gRPC and asyncio. The goal was straightforward: understand consensus deeply enough that I could implement it — and debug it — without leaning on a textbook answer.

The project is on GitHub: [abrange/distkeyvalue](https://github.com/abrange/distkeyvalue).

What I didn't expect was how many subtle bugs could hide in code that *looks* correct. Here are four that took real effort to find, and what they taught me.

---

## 1. `step_down()` wasn't persisting state to disk

When a leader discovers a higher term — from a vote response or an append-entries reply — it should immediately step down to follower. My `step_down()` correctly updated `current_term`, `role`, and `voted_for` in memory. But it never called `backup()` to persist those changes.

```python
# Before
def step_down(self, new_term):
    self.current_term = new_term
    self.role = Role.FOLLOWER
    self.voted_for = None
    # ← nothing written to disk

# After
def step_down(self, new_term):
    self.current_term = new_term
    self.role = Role.FOLLOWER
    self.voted_for = None
    self.backup()  # persist before returning
```

**Why it matters**: If the node crashes immediately after stepping down, it restarts with a stale `current_term` and a stale `voted_for`. It could then grant a vote to a candidate in an old term, violating the election safety guarantee. In a distributed system, "the machine crashed right after that line" isn't a hypothetical — it's an expected failure mode you have to design for.

---

## 2. Heartbeat loop computed `prev_term` once, then went stale

In RAFT, the leader sends heartbeats (empty `AppendEntries` RPCs) to all followers on a regular interval. Each heartbeat includes `prev_idx` and `prev_term` — the index and term of the log entry immediately before what you're about to send.

My original loop computed these values once before the loop started:

```python
# Before — stale after any log append
async def _heartbeat_loop(self):
    prev_idx, prev_term = self.last_index_term()  # computed ONCE
    while self.role == Role.LEADER:
        replies = await asyncio.gather(*(
            self.transport.append_entries(
                target=p,
                prev_idx=self.next_index[p] - 1,
                prev_term=prev_term,  # ← always the value from loop start
                ...
            ) for p in self.peers
        ), return_exceptions=False)
        await asyncio.sleep(HEARTBEAT_INTERVAL)
```

After a client write, `next_index` for each peer updates — but `prev_term` stays frozen at its original value. Followers then reject the heartbeat because the term doesn't match, triggering unnecessary log backtracking.

```python
# After — computed fresh per peer per iteration
async def _heartbeat_loop(self):
    while self.role == Role.LEADER:
        replies = await asyncio.gather(*(
            self.transport.append_entries(
                target=p,
                prev_idx=self.next_index[p] - 1,
                prev_term=self.term_at(self.next_index[p] - 1),  # fresh each time
                ...
            ) for p in self.peers
        ), return_exceptions=False)
        await asyncio.sleep(HEARTBEAT_INTERVAL)
```

This is the kind of bug that only appears under write load — the system looks healthy when idle.

---

## 3. Exceptions were being counted as votes

During an election, a candidate sends `RequestVote` RPCs to all peers in parallel using `asyncio.gather`. I used `return_exceptions=True` so a network timeout on one peer wouldn't crash the whole gather:

```python
results = await asyncio.gather(*(ask(p) for p in self.peers), return_exceptions=True)
votes += sum(1 for r in results if r)  # ← BUG
```

The problem: `return_exceptions=True` means exceptions are returned *as values* in the results list. An `Exception` object is truthy in Python. So a network timeout — which should be a failed vote — was being counted as a successful one.

```python
# After
votes += sum(1 for r in results if r is True)  # strict identity check
```

Using `is True` instead of a truthiness check ensures only a genuine boolean `True` from the RPC counts as a vote. An `Exception`, a `None`, or a `False` all correctly fail the check.

This bug could cause a node to win an election it shouldn't have, particularly during partial network failures — exactly the scenario where correctness matters most.

---

## 4. `voted_for` wasn't cleared when stepping down mid-election

Related to bug #1: when a candidate steps down mid-election (because it sees a higher term), it should clear `voted_for`. My original `ask()` helper called `self.current_term = new_term` and `self.role = Role.FOLLOWER` directly, bypassing `step_down()`.

```python
# Before
async def ask(p) -> bool:
    received_term, ok = await self.transport.request_vote(...)
    if received_term > self.current_term:
        self.current_term = received_term  # ← voted_for not cleared
        self.role = Role.FOLLOWER
        return ok  # ← still returns True even after stepping down

# After
async def ask(p) -> bool:
    received_term, ok = await self.transport.request_vote(...)
    if received_term > self.current_term:
        self.step_down(received_term)  # clears voted_for + persists
        return False  # do not count as a vote even if ok=True
    return ok
```

Two fixes here: routing through `step_down()` ensures `voted_for` is always cleared consistently (and persisted), and returning `False` explicitly means we don't accidentally count this peer's response as a vote after we've already given up the election.

---

## What I learned

Building RAFT from scratch was one of the most educational things I've done as an engineer. The paper makes the algorithm feel clean and well-defined — and it is, at a high level. But the implementation surface is full of edge cases that only matter in failure scenarios: crashes right after a state change, concurrent RPCs arriving out of order, network partitions that heal at the wrong moment.

A few patterns that became habits after this:

- **Persist before returning.** If a state change matters for correctness, it needs to be durable before the function returns. Memory is ephemeral; disk is the contract.
- **Truthiness is not the same as correctness.** In Python, `if r` and `if r is True` are very different when `r` might be an exception or `None`.
- **Centralize state transitions.** Functions like `step_down()` should be the single path for their transition, so invariants (like clearing `voted_for`) are guaranteed everywhere.

The full implementation — including snapshots, log compaction, and InstallSnapshot — is at [github.com/abrange/distkeyvalue](https://github.com/abrange/distkeyvalue).

---

*Next post: building a minimal agent tool-use loop from scratch with Python asyncio.*

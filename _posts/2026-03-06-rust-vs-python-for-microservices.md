---
layout: post
title: "Rust vs Python for Microservices: What Actually Changes in Production"
date: 2026-03-06
categories: [rust, python, engineering]
tags: [rust, python, microservices, production, backend]
---

I've been writing Python for over a decade and Rust for the last four years — both in production, both for backend microservices. I'm not here to tell you Rust is always better. I'm here to tell you what *actually changed* when we started using it, and when I'd still reach for Python without hesitation.

This isn't a benchmark post. It's a field report.

---

## What I Didn't Expect: The Safety Guarantees

The performance story is the one everyone leads with. I'll get there. But the thing that surprised me most was how much Rust changed the *feedback loop* during development — specifically, how many entire categories of bugs just stopped happening.

### The silent variable reassignment bug

This one is embarrassingly common in Python. You're deep in a function, you write:

```python
def process_order(order):
    oder_id = order["id"]   # typo — this creates a new variable silently
    # ... 40 lines later ...
    print(f"Processing order {order_id}")  # NameError at runtime, or stale value
```

The typo (`oder_id` instead of `order_id`) creates a new variable. Python won't tell you until runtime — and sometimes not even then if the code path isn't hit immediately.

In Rust, this doesn't compile:

```rust
fn process_order(order: &Order) {
    let oder_id = order.id;  // warning: unused variable `oder_id`
    println!("Processing order {}", order_id);  // error: cannot find value `order_id`
}
```

You get the error before you run anything.

### The KeyError that only happens in production

Python dictionaries are convenient, but they're a footgun when the data doesn't match your assumptions:

```python
def get_status(event: dict) -> str:
    return event["status"]  # KeyError if "status" isn't there
```

You write this, you test it with your sample data (which always has `"status"`), it ships. Three weeks later, a slightly different event format shows up and your service crashes.

In Rust, `HashMap::get()` returns an `Option<&V>`. You're forced to handle the absence:

```rust
fn get_status(event: &HashMap<String, String>) -> Option<&str> {
    event.get("status").map(|s| s.as_str())
}
```

Or if you're confident it's always there, you say so explicitly — and the crash, if it happens, is at the point of the assumption, not somewhere downstream where it's hard to trace.

### The None that slips through

Python's `None` is everywhere, and type checkers help, but they're optional and often not enforced end-to-end:

```python
def get_user(user_id: str) -> User | None:
    return db.find(user_id)

def display_name(user: User) -> str:
    return user.name.upper()  # AttributeError if user is None — and nothing warned you
```

In Rust, if a function returns `Option<User>`, you cannot call `.name` on it without unwrapping first. The compiler won't let you pretend it's not optional:

```rust
fn display_name(user: Option<User>) -> String {
    match user {
        Some(u) => u.name.to_uppercase(),
        None => String::from("Unknown"),
    }
}
```

### The refactoring that breaks silently

This is the one I feel most grateful for. We have a large codebase with modest test coverage. When I need to rename a field, add a required parameter, or change a function signature in Python, I run the refactor and then *hope* I caught everything. Sometimes I find the missed callsite days later in a production log.

In Rust, the compiler finds every callsite immediately:

```
error[E0560]: struct `Order` has no field named `product_sku`
  --> src/handlers/order.rs:47:9
   |
47 |         product_sku: item.sku,
   |         ^^^^^^^^^^^ help: a field with a similar name exists: `sku`
```

We've done significant refactors with confidence we didn't have before. The compiler is doing the work that our test suite wasn't.

---

## The Performance Story

Now for the numbers.

We run comparable services in both Rust and Python — similar workloads, event processing, database queries, structured output. The Python service is a FastAPI app. The Rust service uses Axum.

At idle and under moderate load:

| | Python (FastAPI) | Rust (Axum) |
|---|---|---|
| Memory at idle | ~180–220 MB | ~18–22 MB |
| Memory under load | spikes to 400–500 MB | stays flat ~30 MB |
| CPU at steady traffic | 15–30% | 2–5% |
| p99 latency | 80–120 ms | 8–15 ms |

The memory difference — roughly 10× — is the one that directly affects infrastructure costs. The *stability* is what affects on-call quality. Python's garbage collector makes memory usage harder to predict under bursty traffic; Rust's ownership model means memory is freed deterministically.

---

## You Don't Need to Master Lifetimes to Ship

The Rust learning curve discussion tends to center on lifetimes and the borrow checker. It's a real challenge, but it's overstated for typical service work.

The truth is: most microservice code doesn't need complex lifetime annotations. When you're handling an HTTP request, querying a database, and returning a JSON response, you're mostly working with owned data — `String`, `Vec`, your own structs. The compiler guides you through the edge cases.

I still don't have lifetimes fully internalized. But I've shipped production services with Axum, handled concurrency with Tokio, and done complex query work with SQLx without ever needing to go deep on `'a` lifetime annotations. You'll encounter them — but they won't block you from making real progress.

---

## SQLx: Direct SQL Without the ORM Tax

This one is personal preference, but I've come to love it: [SQLx](https://github.com/launchbadge/sqlx) lets you write plain SQL validated at compile time.

```rust
let orders = sqlx::query_as!(
    Order,
    "SELECT id, customer_id, status, created_at FROM orders WHERE status = $1",
    status.as_str()
)
.fetch_all(&pool)
.await?;
```

If I rename the `status` column in a migration without updating this query, it fails at **compile time** — not at runtime. The SQL is right there: no ORM abstraction to decode, no `QuerySet` to trace, no `JOIN` that materializes differently than you expect.

For complex queries — multiple joins, conditional filters, window functions — this is a significant advantage over ORMs. You read the query and you know exactly what hits the database.

---

## Enums With Associated Data

Rust enums are not Python's `enum.Enum`. They're algebraic data types, and they change how you model domain logic.

We have an internal domain-specific language. Instead of parsing tokens into strings and checking them everywhere downstream, we define:

```rust
#[derive(Debug, Clone)]
pub enum Token {
    StringLiteral(String),
    Float(f64),
    Boolean(bool),
    Integer(i64),
    Identifier(String),
    If,
    Else,
    Return,
    Assign,
    // ...
}
```

The type carries the data. Pattern matching on `Token` is exhaustive — if you add a new token type and forget to handle it somewhere, the compiler tells you:

```rust
match token {
    Token::If => handle_if(),
    Token::Else => handle_else(),
    Token::StringLiteral(s) => handle_string(s),
    // error: non-exhaustive patterns: `Token::Float(_)` not covered
}
```

This pattern — enums as first-class domain models — is something I genuinely miss when I go back to Python.

---

## When I'd Still Choose Python

Rust isn't the right tool for every service. Here's when I'd keep Python without hesitation:

**ML-heavy services.** The Python ML ecosystem is unmatched. PyTorch, HuggingFace, scikit-learn, NumPy — the Rust bindings exist but they're well behind in breadth and community. If your service is doing model inference, training, or heavy data science work, Python is the right call. You can still use Rust at the edges — for a fast preprocessing layer or an API gateway — but keep the ML core in Python.

**Batch jobs where throughput isn't the bottleneck.** If a batch job runs nightly and takes 4 minutes in Python, rewriting it in Rust to take 30 seconds rarely justifies the investment. Save Rust for services where latency or memory are actually causing problems in production.

**When time-to-production is the constraint.** Python is faster to write and faster to iterate on. If you're building a prototype, an internal tool, or something with a short lifespan, Rust's upfront investment may not pay off. On longer-lived codebases — 18+ months — the safety guarantees and refactoring story tend to shift the math significantly.

If you do stay in Python, invest in type annotations enforced by [Pyright](https://github.com/microsoft/pyright) or Pylance, and build solid unit test coverage early. You can catch a lot of what Rust's compiler gives you for free — it just requires more discipline to enforce.

**A note on compilation time.** Rust compiles slower than Python "compiles" (which doesn't at all). Incremental builds are fast, but a clean build on a large project takes time. I don't find this a meaningful drawback. The ratio of compile time to production runtime is heavily weighted toward the latter — I'd rather wait 90 seconds at my desk than chase a `None` bug through a production log at midnight. You're optimizing for the right side of that equation.

---

## AI Assistance Changes the Calculus

One thing worth saying directly: the difficulty of writing Rust has dropped significantly with AI coding tools.

The parts that used to slow people down — getting the borrow checker right, remembering trait bounds, wiring up error types — are now areas where an AI assistant can help iteratively. More importantly, Rust's compile errors are precise and structured, which makes them *ideal* for agentic coding workflows: the agent writes code, runs `cargo check`, reads the error, fixes it, and loops until it compiles.

The Rust compiler is effectively giving the agent a correctness oracle. That's not something you get the same way with Python. If you've been putting off Rust because of the learning curve, now is a genuinely good time to revisit that.

---

## Summary

Rust earns its place in a microservice stack when:
- The service is long-lived and will be refactored repeatedly
- Memory efficiency and latency actually matter
- You want the compiler to eliminate entire categories of runtime bugs
- You're modeling a rich domain with complex state

Keep Python when:
- ML libraries are central to the service
- The service is a short-lived batch job or prototype
- Time-to-production is the primary constraint

The two coexist fine in the same stack. The key is being deliberate about which one you're choosing, and why.

---

*Have thoughts or experience with this yourself? I'd love to hear it — find me on [X](https://x.com/abrange) or [GitHub](https://github.com/abrange).*

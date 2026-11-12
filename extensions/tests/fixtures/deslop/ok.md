# Moving the queue to Postgres

We replaced the Redis-backed job queue with a table in Postgres last month. The
reason was durability: a Redis restart dropped queued jobs twice in February, and
both times we had to work out by hand which invoices had not been generated. That
took about three hours each time.

## How it works

Workers claim a row with `SELECT ... FOR UPDATE SKIP LOCKED`, process it, and mark
it done. A janitor query requeues rows whose lease expired, which covers a worker
crash. The schema is four columns: id, payload, lease_until, attempts.

Throughput went from 1,200 jobs per minute to 900. That is a real cost and it is
the main objection to this change. For our volume, which peaks around 400 per
minute in the busiest hour of the month, the headroom is still comfortable.

## What we learned

The skip-locked pattern is easier to reason about than a broker, and the queue is
now included in the same backup as the data it describes, which is a genuine
improvement in incident recovery.

The comprehensive monitoring story is less good. We lost the broker's built-in
metrics, so queue depth is now a hand-written query on a dashboard, and that query
scans the whole table, which is a robust way to slow down a dashboard but not much
else. Two engineers have asked for a materialised view and nobody has built it.

Retries are capped at five, and after that the job lands in a dead-letter table
that nothing reads yet. That is a gap. We know about it, and it is the next piece
of work rather than something we are pretending is finished.

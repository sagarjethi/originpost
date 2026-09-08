# Separate durable records, delivery queues, and media objects

OriginPost uses PostgreSQL as the durable system of record, Redis only for rebuildable delivery work, and private S3-compatible storage for media and captured evidence. This avoids treating a queue as truth, keeps large files out of database rows, and lets the scheduler recover missing jobs from durable PostgreSQL records.

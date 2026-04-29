# Kafka seed

`topics.json` defines the topics and sample messages that the shared container stack
creates on start. The seed is applied via the node-side admin client (`kafkajs`) from
`src/test/shared/containers.ts` once the broker is reachable — Kafka itself has no
initdb hook comparable to Postgres.

Format:

```
[
  { "name": "<topic>", "numPartitions": N, "replicationFactor": 1, "messages": [{ "key": ..., "value": ... }] }
]
```

Idempotency: topic creation uses `allowAutoTopicCreation` / existing-topic checks, and
messages are produced once per test run — duplicate messages across re-runs are expected
and harmless because tests read by partition+offset, not by count.

For a manual run inside the container:

```
docker compose -f tests/docker-compose.e2e.yml exec kafka kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --topic events --partitions 3 --replication-factor 1
```

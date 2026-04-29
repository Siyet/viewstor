# Redis seed

`seed.txt` is a plain command-per-line script applied via

```
docker compose -f tests/docker-compose.e2e.yml exec -T redis redis-cli < tests/seed/redis/seed.txt
```

Tests call `applyRedisSeed(container)` from `src/test/shared/containers.ts` which streams the
same file into the container. `FLUSHDB` is issued per DB before seeding, so re-running is safe.

Layout:
- DB 0 — "app data": strings, list, set, zset, hash, stream, PII keys for anonymization tests
- DB 1 — "env": configuration-style keys
- DB 2 — "tenant": hash-heavy keys for schema-tree coverage

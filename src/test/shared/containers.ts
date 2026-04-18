import * as path from 'path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

export interface PgInfo {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface ChInfo {
  host: string;
  httpPort: number;
  username: string;
  password: string;
  database: string;
}

export interface RedisInfo {
  host: string;
  port: number;
}

export interface KafkaInfo {
  brokers: string[];
}

export interface TestStack {
  pg?: PgInfo;
  ch?: ChInfo;
  redis?: RedisInfo;
  kafka?: KafkaInfo;
  _containers: StartedTestContainer[];
}

export interface StackOptions {
  pg?: boolean;
  ch?: boolean;
  redis?: boolean;
  kafka?: boolean;
}

const SEED_ROOT = path.resolve(__dirname, '..', '..', '..', 'tests', 'seed');

// testcontainers exposes reuse only when the env flag is set — it's an opt-in feature
// that requires a cooperating Docker daemon (Docker Desktop + Testcontainers Cloud or
// TESTCONTAINERS_REUSE_ENABLE=true).  Outside of a developer laptop we skip it.
const REUSE = process.env.TESTCONTAINERS_REUSE_ENABLE === 'true';

async function startPostgres(): Promise<{ container: StartedTestContainer; info: PgInfo }> {
  let builder = new GenericContainer('pgvector/pgvector:pg16')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'viewstor',
      POSTGRES_PASSWORD: 'viewstor',
      POSTGRES_DB: 'viewstor_test',
    })
    .withCopyDirectoriesToContainer([
      { source: path.join(SEED_ROOT, 'postgres'), target: '/docker-entrypoint-initdb.d' },
    ])
    // Postgres prints "ready to accept connections" twice during initdb — wait for the second.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000);

  if (REUSE) {
    builder = builder.withReuse();
  }

  const container = await builder.start();
  return {
    container,
    info: {
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'viewstor',
      password: 'viewstor',
      database: 'viewstor_test',
    },
  };
}

async function startClickHouse(): Promise<{ container: StartedTestContainer; info: ChInfo }> {
  let builder = new GenericContainer('clickhouse/clickhouse-server:24-alpine')
    .withExposedPorts(8123, 9000)
    .withEnvironment({
      CLICKHOUSE_USER: 'default',
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
      CLICKHOUSE_SKIP_USER_SETUP: '1',
    })
    .withCopyDirectoriesToContainer([
      { source: path.join(SEED_ROOT, 'clickhouse'), target: '/docker-entrypoint-initdb.d' },
    ])
    .withWaitStrategy(Wait.forHttp('/ping', 8123).forStatusCode(200))
    .withStartupTimeout(120_000);

  if (REUSE) {
    builder = builder.withReuse();
  }

  const container = await builder.start();
  return {
    container,
    info: {
      host: container.getHost(),
      httpPort: container.getMappedPort(8123),
      username: 'default',
      password: '',
      database: 'viewstor_test',
    },
  };
}

async function startRedis(): Promise<{ container: StartedTestContainer; info: RedisInfo }> {
  let builder = new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withCopyDirectoriesToContainer([
      { source: path.join(SEED_ROOT, 'redis'), target: '/seed' },
    ])
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(60_000);

  if (REUSE) {
    builder = builder.withReuse();
  }

  const container = await builder.start();

  // Apply seed via redis-cli inside the container. Keep the output for diagnostics but don't
  // fail the start if the seed itself errors — individual tests will surface a clearer message
  // against the actual key they need.
  const exec = await container.exec(['sh', '-c', 'redis-cli < /seed/seed.txt']);
  if (exec.exitCode !== 0) {
    throw new Error(`Redis seed failed (exit ${exec.exitCode}): ${exec.output}`);
  }

  return {
    container,
    info: { host: container.getHost(), port: container.getMappedPort(6379) },
  };
}

async function startKafka(): Promise<{ container: StartedTestContainer; info: KafkaInfo }> {
  // KRaft single-node. Advertised listener needs to point at host:mappedPort, so we start with
  // a placeholder and we expose the resolved broker through `brokers`.
  let builder = new GenericContainer('bitnami/kafka:3.7')
    .withExposedPorts(9092)
    .withEnvironment({
      KAFKA_CFG_NODE_ID: '1',
      KAFKA_CFG_PROCESS_ROLES: 'broker,controller',
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CFG_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CFG_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      // Advertise on localhost; the mapped port matches 9092 from the test host's POV
      // because testcontainers sets up 127.0.0.1:<mapped>->container:9092 forwarding.
      KAFKA_CFG_ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:9092',
      ALLOW_PLAINTEXT_LISTENER: 'yes',
      KAFKA_CFG_AUTO_CREATE_TOPICS_ENABLE: 'true',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(180_000);

  if (REUSE) {
    builder = builder.withReuse();
  }

  const container = await builder.start();
  const host = container.getHost();
  const port = container.getMappedPort(9092);
  return {
    container,
    info: { brokers: [`${host}:${port}`] },
  };
}

/**
 * Start the shared test stack.  Each requested service spins up in parallel; services default
 * to pg/ch/redis enabled (Kafka is opt-in since it's the heaviest image).
 *
 * Returns the connection endpoints plus the underlying StartedTestContainer list; pass the
 * same object to `stopTestStack` to tear down.
 */
export async function startTestStack(options: StackOptions = {}): Promise<TestStack> {
  const opts: Required<StackOptions> = {
    pg: options.pg ?? true,
    ch: options.ch ?? true,
    redis: options.redis ?? true,
    kafka: options.kafka ?? false,
  };

  const tasks: Array<Promise<{ key: keyof TestStack; container: StartedTestContainer; info: unknown }>> = [];
  if (opts.pg) {
    tasks.push(startPostgres().then(r => ({ key: 'pg' as const, container: r.container, info: r.info })));
  }
  if (opts.ch) {
    tasks.push(startClickHouse().then(r => ({ key: 'ch' as const, container: r.container, info: r.info })));
  }
  if (opts.redis) {
    tasks.push(startRedis().then(r => ({ key: 'redis' as const, container: r.container, info: r.info })));
  }
  if (opts.kafka) {
    tasks.push(startKafka().then(r => ({ key: 'kafka' as const, container: r.container, info: r.info })));
  }

  const results = await Promise.all(tasks);
  const stack: TestStack = { _containers: [] };
  for (const r of results) {
    stack._containers.push(r.container);
    (stack as Record<string, unknown>)[r.key] = r.info;
  }
  return stack;
}

export async function stopTestStack(stack: TestStack | undefined): Promise<void> {
  if (!stack) return;
  await Promise.all(
    stack._containers.map(async c => {
      try {
        await c.stop();
      } catch {
        // ignore teardown errors; the container may already be gone when reuse is on
      }
    }),
  );
  stack._containers = [];
}

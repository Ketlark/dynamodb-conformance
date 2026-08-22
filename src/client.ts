import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBStreamsClient } from '@aws-sdk/client-dynamodb-streams'
import { commonConfig } from './aws-config.js'

// DynamoDBDocumentClient is deliberately excluded.
// Raw AttributeValue maps test DynamoDB's type system more precisely.

// Retry policy, declared rather than inherited. These are the SDK v3 defaults
// (standard mode, three attempts), pinned in code because the suite's result
// classification depends on them: a throttle or transient 5xx that reaches a
// caller has by definition survived this policy, which is what lets
// src/indeterminate.ts treat it as a failed observation rather than an answer.
const retryConfig = {
  maxAttempts: 3,
  retryMode: 'standard',
} as const

// Connect timeout, pinned for the same reason as the retry policy and left
// unset by the SDK: @smithy/node-http-handler applies no connectionTimeout of
// its own, so establishing a TCP connection is bounded only by the kernel,
// which gives up on an unroutable address after roughly two minutes. Both
// outcomes classify as `transport` either way, so this changes how long a
// failed observation takes to reach that verdict, never what the verdict is.
//
// Only the connection is bounded. requestTimeout stays off: a control-plane
// call that legitimately runs long (a table creation, a GSI backfill) must not
// be cut off and misread as a failed observation.
const CONNECTION_TIMEOUT_MS = 5_000

const httpConfig = {
  requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS },
} as const

/** Low-level DynamoDB client */
export const ddb = new DynamoDBClient({ ...commonConfig, ...retryConfig, ...httpConfig })

/** DynamoDB Streams client */
export const ddbStreams = new DynamoDBStreamsClient({ ...commonConfig, ...retryConfig, ...httpConfig })

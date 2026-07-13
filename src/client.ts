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

/** Low-level DynamoDB client */
export const ddb = new DynamoDBClient({ ...commonConfig, ...retryConfig })

/** DynamoDB Streams client */
export const ddbStreams = new DynamoDBStreamsClient({ ...commonConfig, ...retryConfig })

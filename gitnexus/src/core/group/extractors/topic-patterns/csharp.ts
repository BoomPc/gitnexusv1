import CSharp from 'tree-sitter-c-sharp';
import { compilePatterns, type LanguagePatterns } from '../tree-sitter-scanner.js';
import type { TopicMeta } from './types.js';

/**
 * C# topic extraction patterns for AIHelp-style RabbitMQ usage.
 *
 * Detects a custom RabbitMQ wrapper pattern:
 *   - `RabbitMQFactory.XXX().PublishMsg(...)`           (provider)
 *   - `RabbitMQFactory.XXX().PublishMsgByConsistentHash(...)` (provider)
 *   - `services.AddDynamicHostService<XxxHostedService>(config?.XXX)`   (consumer)
 *   - `services.AddHashActivatorHostService<XxxHostedService>(...)`     (consumer)
 *   - `services.AddHostedService<XxxHostedService>()`                   (consumer)
 *
 * The factory method name (e.g. `Notification`, `RedisTicketToMongo`) serves
 * as the logical topic identifier, since the actual queue/exchange names are
 * resolved at runtime from Apollo config.
 *
 * Every query MUST bind `@value` to the node whose text is the logical topic name.
 */
const CSHARP_TOPIC_SPEC: LanguagePatterns<TopicMeta> = {
  name: 'csharp-topic',
  language: CSharp,
  patterns: [
    {
      meta: {
        role: 'provider',
        broker: 'rabbitmq',
        confidence: 0.85,
        symbolName: 'RabbitMQFactory.PublishMsg',
      },
      query: `
        (invocation_expression
          function: (member_access_expression
            expression: (invocation_expression
              function: (member_access_expression
                expression: (identifier) @factory (#eq? @factory "RabbitMQFactory")
                name: (identifier) @value))
            name: (identifier) @method (#match? @method "^PublishMsg")))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'rabbitmq',
        confidence: 0.7,
        symbolName: 'AddDynamicHostService',
      },
      query: `
        (invocation_expression
          function: (member_access_expression
            name: (generic_name
              (identifier) @regMethod (#eq? @regMethod "AddDynamicHostService")
              (type_argument_list (identifier) @value))))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'rabbitmq',
        confidence: 0.65,
        symbolName: 'AddHashActivatorHostService',
      },
      query: `
        (invocation_expression
          function: (member_access_expression
            name: (generic_name
              (identifier) @regMethod (#eq? @regMethod "AddHashActivatorHostService")
              (type_argument_list (identifier) @value))))
      `,
    },
    {
      meta: {
        role: 'consumer',
        broker: 'rabbitmq',
        confidence: 0.6,
        symbolName: 'AddHostedService',
      },
      query: `
        (invocation_expression
          function: (member_access_expression
            name: (generic_name
              (identifier) @regMethod (#eq? @regMethod "AddHostedService")
              (type_argument_list (identifier) @value))))
      `,
    },
  ],
};

export const CSHARP_TOPIC_PROVIDER = compilePatterns(CSHARP_TOPIC_SPEC);

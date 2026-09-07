import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// cordis plugin: the config from the store patch row is passed through to apply(ctx, config).
// applist.yaml → node_src/cordis.patch.yml config → validated/defaulted by Config → apply.
export const name = "dotdsh-hello-world";
export const inject = ["tools"];

export const Config = z.object({
  greeting: z.string().default("Hello from dotdsh"),
});

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "hello_world",
    description:
      "Say hello to the given name. The greeting comes from the dotdsh plugin store's applist.yaml configuration (config.greeting).",
    parameters: {
      name: {
        type: "string",
        required: true,
        description: "The name to greet",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          message: {
            type: "string",
            required: true,
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value.message,
        },
      ],
    },
    execute(args) {
      return Promise.resolve({ message: `${config.greeting}, ${args.name}!` });
    },
  }));
}

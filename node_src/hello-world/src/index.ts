import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// cordis plugin: the config from the store patch row is passed through to apply(ctx, config).
// applist.yaml → node_src/dotdsh/cordis.patch.yml config → validated/defaulted by Config → apply.
export const name = "dotdsh-hello-world";
export const inject = ["tools"];

/** Hello-world plugin configuration. */
export interface Config {
  /** The greeting used by the `hello_world` tool. */
  greeting: string;
}

/** Schemastery configuration for the hello-world plugin. */
export const Config: z<Config> = z.object({
  greeting: z.string().default("Hello from dotdsh"),
});

/** Register the `hello_world` tool on `ctx.tools`. */
export function apply(ctx: Context, config: Config): void {
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

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// cordis plugin: the config on this plugin's row in the bundle patch
// (node_src/dotdsh/cordis.patch.yml) is passed through to apply(ctx, config).
// Row config → validated/defaulted by Config → apply(ctx, config).
// The plugin name follows dsh's convention (package name minus scope and prefix).
export const name = "hello-world";
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
      "Say hello to the given name. The greeting comes from this plugin's row in the dotdsh bundle patch (config.greeting).",
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

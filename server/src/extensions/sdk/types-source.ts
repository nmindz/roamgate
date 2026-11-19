import { readSource } from "./read-source" with { type: "macro" };

/** The SDK declarations `roamgate ext types` writes as roamgate.d.ts. */
export const SDK_TYPES: string = readSource("./types.d.ts");

/** Written next to them when the directory has no tsconfig.json. */
export const SDK_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ESNext"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
    },
    include: ["**/*.ts"],
  },
  null,
  2,
)}\n`;

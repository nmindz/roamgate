// Dynamic imports on purpose: a static import of ./server would load the
// whole bridge into every extension child (about 18 MiB more RSS per mod).
if (process.argv[2] === "__ext-host") {
  const { runExtensionHost } = await import("./extensions/sdk/runtime");
  process.exit(await runExtensionHost(process.argv.slice(3)));
}
await import("./server");

export {};

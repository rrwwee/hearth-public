// Fixtures supply their own installation settings and repository context.
export function fixtureEnvironment(settings = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("HEARTH_") && !key.startsWith("GIT_") && key !== "PORT")),
    ...settings,
  };
}

// Whether to emit the Altino tag. Eleventy reports "serve" or "watch" while
// `npm run dev` is up and "build" for a real build, so local page views never
// land in the production site's stats. accesspatterns.dev gets the same guard
// from `import.meta.env.PROD`; this is the 11ty equivalent.
export default {
  enabled: process.env.ELEVENTY_RUN_MODE === "build",
};

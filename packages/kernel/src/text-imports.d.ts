// Bun imports these as plain strings via `with { type: "text" }`.
declare module "*.md" {
  const content: string;
  export default content;
}

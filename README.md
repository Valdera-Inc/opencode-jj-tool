# OpenCode JJ tool

the plugin exposes a `jj` tool that does read-only operations (status, log, diff)
making it safe to always allow (unlike running `jj` through bash)

## installation

add a blurb to `~/.config/opencode/AGENTS.md` like

> use the jj tool instead of git

### install globally by copying

```sh
mkdir ~/.config/opencode/plugins
cp --reflink index.ts ~/.config/opencode/plugins/jj.ts
cd ~/.config/opencode
bun add @opencode-ai/plugin
```

### install globally via symlink

`node_modules` from the symlink's directory are used
so install dependencies in your clone of this repo

```sh
bun install @opencode-ai/plugin
mkdir ~/.config/opencode/plugins
ln -s "$PWD/index.ts" ~/.config/opencode/plugins/jj.ts
```

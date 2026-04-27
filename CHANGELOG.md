# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [0.1.0] - 2026-04-27

### Added

- add CLI entry point with start, setup, purge subcommands
- add conversation memory module
- add purge command to wipe OpenTentacles state
- add paths module for host-side state dirs
- add DiscordPermissionBroker and handler factory
- add interactive setup script and npm script
- initial commit

### Changed

- address copilot review comments
- commit bun lockfile and remove from gitignore
- ensure secrets store is closed in finally block
- persist partial assistant response when idle never fires
- stop excluding toml files from image build
- bump container-build-flow-action to v1.7.1
- update entrypoints and scripts to use cli.ts
- migrate prompts from readline to @clack/prompts
- export startBot instead of auto-executing
- update app entry point and setup
- update discord channel implementation
- integrate memory into copilot orchestrator
- update config loading and add tests
- update database layer
- extend shared type definitions
- configure package workflow
- update project dependencies
- add Dockerfile and dockerignore for containerization
- integrate paths and updated config bootstrap
- use paths module and node built-ins
- refactor permissions module
- migrate to ConfigEngine and use paths module
- export Logger type from logger and update imports
- add build script and upgrade discord.js to 14.26.3
- wire permission broker into app entry point
- update GitHub copilot core logic
- refactor channel to raw events and broker integration
- update consumers to new config API
- refactor config loader with secrets engine

### Removed

- drop copilotGithubToken in favour of gh CLI auth
- drop env-based config files and gitignore entries

### Security

- serialize history as JSON to prevent prompt injection
- pin GitHub Actions to full commit hashes
- replace MIT license with GPL-3.0


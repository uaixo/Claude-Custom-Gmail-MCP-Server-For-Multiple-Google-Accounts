#!/usr/bin/env node
/**
 * CLI to manage connected Gmail accounts via OAuth.
 *
 *   npm run add-account            Connect a new account (opens browser consent)
 *   npm run list-accounts          List connected accounts and their cred files
 *   npm run remove-account <email> Remove a connected account
 *
 * Multiple OAuth clients are supported: drop several credential files in the
 * data dir (credentials.json, credentials2.json, ...). When more than one is
 * present, add-account asks which to use. Each account records the credential
 * file it was authorized with, so token refresh later uses the right client.
 *
 * Tokens are stored per account email in <dataDir>/tokens.json.
 */
export {};

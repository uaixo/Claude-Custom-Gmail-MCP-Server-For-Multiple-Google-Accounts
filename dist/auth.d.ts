import { OAuth2Client, Credentials } from "google-auth-library";
/**
 * A connected account's persisted state: its OAuth tokens plus a reference to
 * the credential file (OAuth client) used to authorize it. The reference is a
 * basename when the file lives in the data dir, otherwise an absolute path.
 * Because refresh tokens are bound to the issuing OAuth client, this file MUST
 * be used to refresh that account's access token.
 */
export interface StoredAccount {
    tokens: Credentials;
    credentialsFile: string;
}
/** Token store keyed by lower-cased account email. */
export interface TokenStore {
    [email: string]: StoredAccount;
}
interface OAuthClientConfig {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
}
/** Read an OAuth "Desktop app" client config from a specific file. */
export declare function loadClientConfig(file?: string): OAuthClientConfig;
/** Build a fresh OAuth2 client from a specific credential file. */
export declare function newOAuthClient(file?: string): OAuth2Client;
/** Resolve a stored credentialsFile reference to an absolute path. */
export declare function resolveCredentialsFile(stored: string): string;
/**
 * Compute how to persist a credential file reference: a basename when the file
 * lives directly in the data dir, otherwise its absolute path.
 */
export declare function credentialsRefFor(file: string): string;
/**
 * Load the token store, migrating any legacy entries (raw Credentials written
 * before per-account credential files) to the current shape, defaulting their
 * credential file to the basename of the default credentials path.
 */
export declare function loadTokens(): TokenStore;
export declare function saveTokens(store: TokenStore): void;
/** Persist (or update) one account's tokens and credential-file reference. */
export declare function saveAccount(email: string, tokens: Credentials, credentialsFile: string): void;
export declare function listAccounts(): string[];
/** Return the credentialsFile reference recorded for each account. */
export declare function accountCredentials(): Record<string, string>;
export declare function removeAccount(email: string): boolean;
/**
 * Resolve which account to use. If `requested` is provided it must exist.
 * Otherwise, if exactly one account is connected, use it; if several are
 * connected, require the caller to disambiguate.
 */
export declare function resolveAccount(requested?: string): string;
/**
 * Return an authenticated OAuth2 client for the given (resolved) account,
 * built from the credential file that account was authorized with. Refreshed
 * access tokens are persisted automatically.
 */
export declare function getAuthedClient(account: string): OAuth2Client;
export {};

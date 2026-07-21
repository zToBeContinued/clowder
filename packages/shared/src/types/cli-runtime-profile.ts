/**
 * Machine-local CLI runtime profile API types.
 *
 * Environment values are intentionally absent from every response-facing type.
 */
export interface CliRuntimeProfileView {
  readonly id: string;
  readonly displayName: string;
  readonly command?: string;
  /** Environment variable names only; values never leave the API process. */
  readonly envKeys: readonly string[];
  /** Per-key presence flags for secret-style editor inputs. */
  readonly envStatus: readonly { readonly key: string; readonly isSet: true }[];
}

export interface CreateCliRuntimeProfileInput {
  readonly id?: string;
  readonly displayName: string;
  readonly command?: string;
  readonly envSet?: Readonly<Record<string, string>>;
}

export interface PatchCliRuntimeProfileInput {
  readonly displayName?: string;
  /** null clears the executable override. */
  readonly command?: string | null;
  /** Incremental values to add or replace. */
  readonly envSet?: Readonly<Record<string, string>>;
  /** Incremental keys to remove. */
  readonly envRemove?: readonly string[];
}

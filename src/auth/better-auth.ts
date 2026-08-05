export interface BetterAuthOptions {
  databasePath: string;
  secret: string;
  baseURL: string;
}

export async function createBetterAuth(options: BetterAuthOptions): Promise<unknown> {
  // Dynamic imports keep mock-mode development usable before native dependencies are installed.
  const betterAuthPackage = "better-auth";
  const sqlitePackage = "better-sqlite3";
  const [{ betterAuth }, sqliteModule] = await Promise.all([
    import(betterAuthPackage) as Promise<{ betterAuth: (options: unknown) => unknown }>,
    import(sqlitePackage) as Promise<{ default: new (path: string) => unknown }>
  ]);

  const database = new sqliteModule.default(options.databasePath);
  return betterAuth({
    database,
    secret: options.secret,
    baseURL: options.baseURL,
    emailAndPassword: { enabled: false }
  });
}

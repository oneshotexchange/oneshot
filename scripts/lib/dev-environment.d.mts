export function resolveApiDevelopmentEnvironment(
  environment: Record<string, string | undefined>,
  repositoryRoot: string,
): Record<string, string | undefined> & {
  NODE_ENV: 'development';
  NEXT_PUBLIC_APP_URL: string;
  ONESHOT_API_URL: string;
  ONESHOT_DATA_DIR: string;
};

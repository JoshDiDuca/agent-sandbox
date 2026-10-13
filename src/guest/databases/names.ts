import type { DatabasePlan } from '../../core/types.js';

export type DatabaseId = DatabasePlan['database'];
/** The databases a server can run for (SQL Server cannot start inside Windows Sandbox). */
export type ServedDatabase = Exclude<DatabaseId, 'sqlserver'>;

export const DATABASE_NAMES: Record<DatabasePlan['database'], string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL (MariaDB)',
  mongodb: 'MongoDB',
  redis: 'Redis',
  dynamodb: 'DynamoDB Local',
  sqlserver: 'SQL Server',
};

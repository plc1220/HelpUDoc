import knex, { Knex } from 'knex';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'workspaces.db');

export class DatabaseService {
  private db: Knex;

  constructor() {
    this.db = knex({
      client: 'sqlite3',
      connection: {
        filename: DB_PATH,
      },
      useNullAsDefault: true,
    });
  }

  public async initialize(): Promise<void> {
    await this.createWorkspacesTable();
    await this.createFilesTable();
  }

  private async createWorkspacesTable(): Promise<void> {
    const tableExists = await this.db.schema.hasTable('workspaces');
    if (!tableExists) {
      await this.db.schema.createTable('workspaces', (table) => {
        table.string('id').primary();
        table.string('name').notNullable();
        table.timestamps(true, true);
      });
      console.log('Created "workspaces" table.');
    }
  }

  private async createFilesTable(): Promise<void> {
    const tableExists = await this.db.schema.hasTable('files');
    if (!tableExists) {
      await this.db.schema.createTable('files', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable();
        table.string('workspaceId').references('id').inTable('workspaces').onDelete('CASCADE');
        table.enum('storageType', ['local', 's3']).notNullable();
        table.string('path').notNullable(); // Local path or S3 key
        table.timestamps(true, true);
      });
      console.log('Created "files" table.');
    }
  }

  public getDb(): Knex {
    return this.db;
  }
  public async deleteWorkspace(id: string): Promise<void> {
    await this.db('workspaces').where({ id }).del();
  }
}
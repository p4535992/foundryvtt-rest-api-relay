// src/database/adapter.ts
import { Sequelize } from 'sequelize';
import { log } from '../middleware/logger';
import { MemoryStore } from './memoryStore';
import path from 'path';
import fs from 'fs';

export class DatabaseAdapter {
  static getSequelize() {
    const dbUrl = process.env.DATABASE_URL;
    const dbType = process.env.DB_TYPE || 'postgres';
    
    if (dbType === 'memory') {
      log.info('Using in-memory database');
      return new MemoryStore();
    }
    
    if (dbType === 'sqlite') {
      log.info('Using SQLite database');
      
      // Ensure data directory exists
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      const dbPath = path.join(dataDir, 'relay.db');
      log.info(`SQLite database path: ${dbPath}`);
      
      return new Sequelize({
        dialect: 'sqlite',
        storage: dbPath,
        logging: false
      });
    }
    
    // Default to PostgreSQL for production
    if (!dbUrl) {
      log.error('DATABASE_URL environment variable is not set - stopping');
      process.exit(1);
    }
    
    const isProduction = process.env.NODE_ENV === 'production';
    
    return new Sequelize(dbUrl, {
      dialect: 'postgres',
      protocol: 'postgres',
      dialectOptions: {
        ssl: isProduction ? {
          require: true,
          rejectUnauthorized: false
        } : false
      },
      logging: false
    });
  }
}
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export async function ensureDatabaseSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "decks" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "description" text,
      "parent_id" integer,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "cards" (
      "id" serial PRIMARY KEY NOT NULL,
      "deck_id" integer NOT NULL,
      "front" text NOT NULL,
      "back" text NOT NULL,
      "tags" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "description" text;
    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "parent_id" integer;
    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "tags" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "image" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

    CREATE TABLE IF NOT EXISTS "generations" (
      "id" serial PRIMARY KEY NOT NULL,
      "deck_name" text NOT NULL,
      "deck_type" text NOT NULL,
      "status" text NOT NULL,
      "cards_generated" integer NOT NULL DEFAULT 0,
      "page_count" integer NOT NULL DEFAULT 0,
      "duration_ms" integer NOT NULL DEFAULT 0,
      "custom_prompt" text,
      "error_message" text,
      "started_at" timestamp with time zone DEFAULT now() NOT NULL,
      "completed_at" timestamp with time zone
    );

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'decks_parent_id_decks_id_fk'
      ) THEN
        ALTER TABLE "decks"
          ADD CONSTRAINT "decks_parent_id_decks_id_fk"
          FOREIGN KEY ("parent_id") REFERENCES "public"."decks"("id")
          ON DELETE set null ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cards_deck_id_decks_id_fk'
      ) THEN
        ALTER TABLE "cards"
          ADD CONSTRAINT "cards_deck_id_decks_id_fk"
          FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id")
          ON DELETE cascade ON UPDATE no action;
      END IF;
    END $$;
  `);
}

export * from "./schema";

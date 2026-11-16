CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"emoji" text,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "personas" ("name", "emoji", "description", "instructions", "position") VALUES (
	'Filosófica',
	'🦉',
	'Responde com perguntas, sem entregar a solução',
	'Você é um interlocutor socrático. Seu papel é ajudar o usuário a pensar, não pensar por ele.

- Não dê respostas prontas, soluções nem recomendações diretas, mesmo que ele peça. Se ele insistir, explique que a ideia aqui é chegar lá junto.
- Responda principalmente com perguntas: sobre premissas, definições, consequências, contraexemplos e o que ele realmente quer.
- Faça poucas perguntas por vez (uma a três), as mais importantes primeiro.
- Aponte contradições e suposições não ditas com gentileza.
- Quando ele chegar a uma conclusão, devolva a ela uma pergunta que a teste.
- Seja breve: sem textos longos nem listas extensas.',
	0
);

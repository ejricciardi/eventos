CREATE TABLE `eventos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nombre` text NOT NULL,
	`lugar` text,
	`inicio` text NOT NULL,
	`fin` text NOT NULL,
	`modo_venta` text DEFAULT 'vales' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `impresoras` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evento_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`host` text NOT NULL,
	`puerto` integer DEFAULT 9100 NOT NULL,
	`ancho_papel` integer DEFAULT 80 NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `productos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evento_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`categoria` text,
	`precio` integer NOT NULL,
	`sector_id` integer,
	`activo` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sector_id`) REFERENCES `sectores`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `puntos_venta` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evento_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`plataforma` text NOT NULL,
	`imprime_vales` integer,
	`imprime_ticket` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sectores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evento_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`impresora_id` integer,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`impresora_id`) REFERENCES `impresoras`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nombre` text NOT NULL,
	`rol` text NOT NULL,
	`nfc_uid` text,
	`activo` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_nfc_uid_unico` ON `staff` (`nfc_uid`);
CREATE TABLE `cuentas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nombre` text NOT NULL,
	`creada` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eventos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cuenta_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`lugar` text,
	`inicio` text NOT NULL,
	`fin` text NOT NULL,
	`modo_venta` text DEFAULT 'vales' NOT NULL,
	FOREIGN KEY (`cuenta_id`) REFERENCES `cuentas`(`id`) ON UPDATE no action ON DELETE cascade
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
	`clave_dispositivo_hash` text,
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
CREATE TABLE `sesiones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`usuario_id` integer NOT NULL,
	`origen` text NOT NULL,
	`punto_venta_id` integer,
	`expira` text NOT NULL,
	FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`punto_venta_id`) REFERENCES `puntos_venta`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sesiones_token_unico` ON `sesiones` (`token_hash`);--> statement-breakpoint
CREATE TABLE `usuarios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cuenta_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`usuario` text NOT NULL,
	`clave_hash` text,
	`rol` text NOT NULL,
	`nfc_uid` text,
	`activo` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`cuenta_id`) REFERENCES `cuentas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usuarios_usuario_unico` ON `usuarios` (`usuario`);--> statement-breakpoint
CREATE UNIQUE INDEX `usuarios_nfc_uid_unico` ON `usuarios` (`nfc_uid`);
CREATE TABLE `anulaciones` (
	`id` text PRIMARY KEY NOT NULL,
	`evento_id` integer NOT NULL,
	`dispositivo_id` text NOT NULL,
	`venta_id` text NOT NULL,
	`turno_id` text NOT NULL,
	`usuario_id` integer NOT NULL,
	`autorizado_por_id` integer,
	`motivo` text NOT NULL,
	`detalle` text,
	`vales_recuperados` text NOT NULL,
	`creada` text NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `canjes` (
	`id` text PRIMARY KEY NOT NULL,
	`operacion_id` text NOT NULL,
	`evento_id` integer NOT NULL,
	`dispositivo_id` text NOT NULL,
	`punto_venta_id` integer NOT NULL,
	`vale_id` text NOT NULL,
	`evento_vale_id` integer NOT NULL,
	`producto_vale_id` integer NOT NULL,
	`producto_id` integer,
	`firma_valida` integer NOT NULL,
	`usuario_id` integer NOT NULL,
	`creada` text NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `canjes_vale` ON `canjes` (`vale_id`);--> statement-breakpoint
CREATE INDEX `canjes_evento` ON `canjes` (`evento_id`);--> statement-breakpoint
CREATE INDEX `canjes_operacion` ON `canjes` (`operacion_id`);--> statement-breakpoint
CREATE TABLE `conflictos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operacion_id` text NOT NULL,
	`dispositivo_id` text NOT NULL,
	`evento_id` integer NOT NULL,
	`seq` integer,
	`payload` text NOT NULL,
	`recibida` text NOT NULL,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `cuentas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nombre` text NOT NULL,
	`creada` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devoluciones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anulacion_id` text NOT NULL,
	`turno_id` text NOT NULL,
	`medio` text NOT NULL,
	`monto` integer NOT NULL,
	`id_externo` text,
	FOREIGN KEY (`anulacion_id`) REFERENCES `anulaciones`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `devoluciones_turno` ON `devoluciones` (`turno_id`);--> statement-breakpoint
CREATE TABLE `dispositivos` (
	`id` text PRIMARY KEY NOT NULL,
	`punto_venta_id` integer NOT NULL,
	`clave_hash` text NOT NULL,
	`clave_publica` text,
	`creado` text NOT NULL,
	`revocado` text,
	`ultima_sincronizacion` text,
	`desfase_ms` integer,
	FOREIGN KEY (`punto_venta_id`) REFERENCES `puntos_venta`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dispositivos_clave_hash_unique` ON `dispositivos` (`clave_hash`);--> statement-breakpoint
CREATE TABLE `eventos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cuenta_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`lugar` text,
	`inicio` text NOT NULL,
	`fin` text NOT NULL,
	`modo_venta` text DEFAULT 'vales' NOT NULL,
	`vales_validez` text DEFAULT 'fin_evento' NOT NULL,
	`vales_vencimiento` text,
	`minutos_anulacion_cajero` integer DEFAULT 5 NOT NULL,
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
CREATE TABLE `movimientos_caja` (
	`id` text PRIMARY KEY NOT NULL,
	`evento_id` integer NOT NULL,
	`dispositivo_id` text NOT NULL,
	`turno_id` text NOT NULL,
	`tipo` text NOT NULL,
	`monto` integer NOT NULL,
	`motivo` text NOT NULL,
	`usuario_id` integer NOT NULL,
	`autorizado_por_id` integer,
	`creada` text NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `movimientos_caja_turno` ON `movimientos_caja` (`turno_id`);--> statement-breakpoint
CREATE TABLE `movimientos_stock` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evento_id` integer NOT NULL,
	`producto_id` integer NOT NULL,
	`sector_id` integer,
	`tipo` text NOT NULL,
	`cantidad` integer NOT NULL,
	`usuario_id` integer NOT NULL,
	`nota` text,
	`creado` text NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`producto_id`) REFERENCES `productos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `movimientos_stock_evento` ON `movimientos_stock` (`evento_id`);--> statement-breakpoint
CREATE TABLE `operaciones` (
	`id` text PRIMARY KEY NOT NULL,
	`dispositivo_id` text NOT NULL,
	`evento_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`tipo` text NOT NULL,
	`usuario_id` integer,
	`payload` text NOT NULL,
	`hash` text NOT NULL,
	`estado` text NOT NULL,
	`error` text,
	`observaciones` text DEFAULT '[]' NOT NULL,
	`creada` text NOT NULL,
	`recibida` text NOT NULL,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operaciones_dispositivo_seq` ON `operaciones` (`dispositivo_id`,`seq`);--> statement-breakpoint
CREATE INDEX `operaciones_evento` ON `operaciones` (`evento_id`);--> statement-breakpoint
CREATE TABLE `pagos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`venta_id` text NOT NULL,
	`medio` text NOT NULL,
	`monto` integer NOT NULL,
	`recibido` integer,
	`id_externo` text,
	`autorizacion` text,
	`ultimos4` text,
	`verificado` integer NOT NULL,
	FOREIGN KEY (`venta_id`) REFERENCES `ventas`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `pagos_venta` ON `pagos` (`venta_id`);--> statement-breakpoint
CREATE TABLE `productos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`evento_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`codigo` text,
	`categoria` text,
	`precio` integer NOT NULL,
	`sector_id` integer,
	`activo` integer DEFAULT true NOT NULL,
	`controla_stock` integer DEFAULT false NOT NULL,
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
	`tipo` text DEFAULT 'caja' NOT NULL,
	`sector_id` integer,
	`vista_productos` text DEFAULT 'lista' NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sector_id`) REFERENCES `sectores`(`id`) ON UPDATE no action ON DELETE set null
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
CREATE TABLE `turnos` (
	`id` text PRIMARY KEY NOT NULL,
	`evento_id` integer NOT NULL,
	`dispositivo_id` text NOT NULL,
	`punto_venta_id` integer NOT NULL,
	`usuario_id` integer NOT NULL,
	`fondo_inicial` integer NOT NULL,
	`entregado_por_id` integer,
	`abierto` text NOT NULL,
	`cerrado` text,
	`cerrado_por_id` integer,
	`efectivo_declarado` integer,
	`cantidad_ventas_declarada` integer,
	`totales_declarados` text,
	`seq_cierre` integer,
	`apertura_recibida` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `usuarios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cuenta_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`usuario` text NOT NULL,
	`clave_hash` text,
	`rol` text NOT NULL,
	`nfc_uid` text,
	`nfc_hash` text,
	`activo` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`cuenta_id`) REFERENCES `cuentas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usuarios_usuario_unico` ON `usuarios` (`usuario`);--> statement-breakpoint
CREATE UNIQUE INDEX `usuarios_nfc_uid_unico` ON `usuarios` (`cuenta_id`,`nfc_uid`);--> statement-breakpoint
CREATE TABLE `vales` (
	`id` text PRIMARY KEY NOT NULL,
	`evento_id` integer NOT NULL,
	`venta_id` text NOT NULL,
	`producto_id` integer NOT NULL,
	`sector_id` integer,
	`dispositivo_id` text NOT NULL,
	`qr` text NOT NULL,
	`firma_valida` integer NOT NULL,
	`estado` text NOT NULL,
	`emitido` text NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`venta_id`) REFERENCES `ventas`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `vales_venta` ON `vales` (`venta_id`);--> statement-breakpoint
CREATE TABLE `venta_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`venta_id` text NOT NULL,
	`producto_id` integer NOT NULL,
	`nombre` text NOT NULL,
	`precio_unitario` integer NOT NULL,
	`cantidad` integer NOT NULL,
	`subtotal` integer NOT NULL,
	`sector_id` integer,
	FOREIGN KEY (`venta_id`) REFERENCES `ventas`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `venta_items_venta` ON `venta_items` (`venta_id`);--> statement-breakpoint
CREATE INDEX `venta_items_producto` ON `venta_items` (`producto_id`);--> statement-breakpoint
CREATE TABLE `ventas` (
	`id` text PRIMARY KEY NOT NULL,
	`evento_id` integer NOT NULL,
	`dispositivo_id` text NOT NULL,
	`punto_venta_id` integer NOT NULL,
	`turno_id` text NOT NULL,
	`usuario_id` integer NOT NULL,
	`numero` integer NOT NULL,
	`total` integer NOT NULL,
	`con_vales` integer NOT NULL,
	`estado` text NOT NULL,
	`autorizado_por_id` integer,
	`creada` text NOT NULL,
	FOREIGN KEY (`evento_id`) REFERENCES `eventos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dispositivo_id`) REFERENCES `dispositivos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ventas_turno` ON `ventas` (`turno_id`);--> statement-breakpoint
CREATE INDEX `ventas_evento` ON `ventas` (`evento_id`);
CREATE TABLE `application_queue_item_depots` (
	`queue_item_id` text NOT NULL,
	`depot_id` integer NOT NULL,
	`request_position` integer NOT NULL,
	`manifest_id` text,
	PRIMARY KEY(`queue_item_id`, `depot_id`),
	FOREIGN KEY (`queue_item_id`) REFERENCES `application_queue_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "application_queue_item_depots_depot_id_valid" CHECK("application_queue_item_depots"."depot_id" > 0 AND "application_queue_item_depots"."depot_id" <= 4294967295),
	CONSTRAINT "application_queue_item_depots_request_position_valid" CHECK("application_queue_item_depots"."request_position" >= 0),
	CONSTRAINT "application_queue_item_depots_manifest_id_valid" CHECK("application_queue_item_depots"."manifest_id" IS NULL OR ("application_queue_item_depots"."manifest_id" <> '' AND "application_queue_item_depots"."manifest_id" NOT GLOB '*[^0-9]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_queue_item_depots_position_unique` ON `application_queue_item_depots` (`queue_item_id`,`request_position`);--> statement-breakpoint
CREATE TABLE `application_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` integer NOT NULL,
	`kind` text NOT NULL,
	`install_path` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `library`(`app_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "application_queue_items_id_valid" CHECK("application_queue_items"."id" <> ''),
	CONSTRAINT "application_queue_items_app_id_valid" CHECK("application_queue_items"."app_id" > 0 AND "application_queue_items"."app_id" <= 4294967295),
	CONSTRAINT "application_queue_items_kind_valid" CHECK("application_queue_items"."kind" IN ('download', 'reconcile', 'repair')),
	CONSTRAINT "application_queue_items_install_path_valid" CHECK("application_queue_items"."install_path" <> ''),
	CONSTRAINT "application_queue_items_position_valid" CHECK("application_queue_items"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_queue_items_app_id_unique` ON `application_queue_items` (`app_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `application_queue_items_position_unique` ON `application_queue_items` (`position`);
/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Dojo Five
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/sys/printk.h>

#include "fuse.h"

static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

/* The product's one job is this blink period; fuse.c explains who else can change it. */
int demo_blink_ms = CONFIG_DEMO_BLINK_MS;

int main(void)
{
	int err;

	printk("cra_boot_demo v%s, blink %d ms, fuse %s\n", CONFIG_MCUBOOT_IMGTOOL_SIGN_VERSION,
	       CONFIG_DEMO_BLINK_MS, fuse_is_locked() ? "locked" : "clear");
	if (CONFIG_DEMO_GOT_YOU[0] != '\0') {
		printk("Got you! %s\n", CONFIG_DEMO_GOT_YOU);
	}

	if (!boot_is_img_confirmed()) {
		err = boot_write_img_confirmed();
		printk("image confirm: %s (%d)\n", err == 0 ? "ok" : "failed", err);
	}

	err = gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	if (err != 0) {
		printk("led init failed (%d)\n", err);
		return 0;
	}

	while (true) {
		(void)gpio_pin_toggle_dt(&led);
		k_msleep(demo_blink_ms);
	}

	return 0;
}

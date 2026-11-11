# Root of Trust to Release

Attack a connected device's boot chain three times, and fix it each time with
Zephyr and MCUboot. The companion demo to the talk *Root of Trust to Release:
Boot-Level Security with Zephyr and MCUboot on the PIC32CK*.

Board: Microchip PIC32CK SG01 Curiosity Nano+ Touch (EV33V87A).

## Run it

Nothing to install. The firmware is prebuilt and the page flashes it for you.

1. Plug the board into your computer with a USB cable.
2. Open https://dojofive.github.io/cra-boot-security-pic32ck/ in Chrome or Edge on a desktop.
3. Select **Connect** for Serial, then for Debugger.
4. Work down the page. Each step says whether you are the OEM or the attacker,
   and shows the console line to expect.

No board? Open the page anyway and read along: every step lists what the
board prints.

## The story

You ship a product with firmware updates. Then you switch sides and break it,
switch back and fix it, and repeat.

After the first step the product is in the field. The two bootloader fixes
cannot arrive as updates, because an update replaces the application and never
MCUboot itself, so each one means rolling a truck to the units. That is the
point: these options cost one line each before the first unit ships.

| Round | Attack | Fix | Option |
| --- | --- | --- | --- |
| 1 | Send a forged update. MCUboot checks only a hash, and anyone can compute a hash. | Check a signature on every boot. | `SB_CONFIG_BOOT_SIGNATURE_TYPE_ECDSA_P256=y` |
| 2 | Send back an old, genuinely signed version that still has a known bug. | Refuse versions that are not newer. | `CONFIG_MCUBOOT_DOWNGRADE_PREVENTION=y` |
| 3 | Rewrite flash through the debug port. | Lock the debug port. | Simulated, see below |

## Where to look

| Path | What is there |
| --- | --- |
| `app/sysbuild.conf` | Turns on MCUboot and picks the signature type. |
| `app/sysbuild/` | MCUboot's own options, downgrade prevention among them. |
| `app/prj.conf` | The application: MCUmgr updates over the serial console. |
| `app/src/` | A blinky, plus the simulated debug lock and the bug that round 2 exploits. |
| `app/attacker/` | Configuration for the attacker's two images. |
| `scripts/build-firmware.sh` | Every image the page serves, and the exact flags that produce it. |
| `web/` | The page. WebHID drives the on-board debugger; Web Serial sends updates. |
| `patches/` | Board support that this Zephyr commit does not have yet. |

## If a board stops responding

Run step 1 again. Every flash step resets the chip into its boot ROM first, so
it works whatever state the board is in, a blank chip included. Plug in only
one board at a time: the browser cannot tell which serial port belongs to
which debugger.

## Build it yourself

You need Docker and the [devcontainer CLI](https://github.com/devcontainers/cli).
The first run downloads Zephyr and its SDK.

```console
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . scripts/build-site.sh
devcontainer exec --workspace-folder . python3 -m http.server -d site 8000
```

Then open http://localhost:8000. The page must come from a web server; browsers
block WebHID and Web Serial on `file://` URLs.

## What a product needs beyond this demo

- **Your own signing key.** The images here are signed with MCUboot's public
  test key. Set `SB_CONFIG_BOOT_SIGNATURE_KEY_FILE` to a key that you generate
  and keep off developer machines.
- **A real debug lock.** The lock in round 3 is a marker in flash that the
  page chooses to honor, so the board stays reusable. A product sets the
  PIC32CK debug access level instead.
- **A hardware rollback counter.** The version check in round 2 lives in
  flash. `CONFIG_MCUBOOT_HW_DOWNGRADE_PREVENTION` moves it to a counter that
  firmware cannot wind back.

## License

Apache-2.0. The Microchip flash algorithms that the page downloads at build
time carry Microchip's own license, which is published next to them.

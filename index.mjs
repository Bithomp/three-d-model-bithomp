import chalk from "chalk";
import puppeteer from "puppeteer";
import express from "express";
import sharp from "sharp";
import * as FileType from "file-type";
import * as fs from "fs/promises";
import crypto from "crypto";

import * as Relative from "./relative.mjs";

const USAGE_MESSAGE = `
Usage: node index.js <path/to/in/3d_model> <path/to/out/preview>

  <path/to/in/3d_model> The filename of the 3D model to render
  <path/to/out/preview> The filename to save the preview image to
`;

const redirectToModelSize = 80 * 1024 * 1024; // 80 megabytes in bytes - for how big models should be redirected to file instead of sending them in response
const idleTime = 9; // 9 seconds - for how long there should be no network requests
const parseTime = 1; // 1 seconds per megabyte

const networkTimeout = 5; // 5 minutes, set to 0 to disable
const renderTimeout = 5; // 5 seconds, set to 0 to disable

const width = 1024;
const height = 1024;
const viewScale = 2;

console.red = (msg) => console.log(chalk.red(msg));
console.yellow = (msg) => console.log(chalk.yellow(msg));
console.green = (msg) => console.log(chalk.green(msg));

const pathToIn3dModel = process.argv[2];
const pathToOutPreview = process.argv[3];

if (!pathToIn3dModel) {
  console.log(USAGE_MESSAGE);
  process.exit(2);
}

if (!pathToOutPreview) {
  console.log(USAGE_MESSAGE);
  process.exit(3);
}

let browser;
let tempModelFileName;
/* Launch server */
let port;
const app = express();
app.use(express.static(Relative.fullPath("public")));
const server = app.listen(0, "127.0.0.1", main);

process.on("SIGINT", () => close());

async function main() {
  port = server.address().port;
  console.log(`Server listening on port ${port}`);

  /* Launch browser */

  const flags = [
    "--hide-scrollbars",
    "--enable-gpu",
    "--no-sandbox",
    "--disable-site-isolation-trials",
    "--disable-dev-shm-usage",
  ];
  // flags.push(
  //   "--enable-unsafe-webgpu",
  //   "--enable-features=Vulkan",
  //   "--use-gl=swiftshader",
  //   "--use-angle=swiftshader",
  //   "--use-vulkan=swiftshader",
  //   "--use-webgpu-adapter=swiftshader"
  // );
  // if (process.platform === "linux")
  //   flags.push(
  //     "--enable-features=Vulkan,UseSkiaRenderer",
  //     "--use-vulkan=native",
  //     "--disable-vulkan-surface",
  //     "--disable-features=VaapiVideoDecoder",
  //     "--ignore-gpu-blocklist",
  //     "--use-angle=vulkan"
  //   );

  const viewport = { width: width * viewScale, height: height * viewScale };

  browser = await puppeteer.launch({
    headless: process.env.VISIBLE ? false : "new",
    args: flags,
    defaultViewport: viewport,
    handleSIGINT: false,
    protocolTimeout: 0,
  });

  // this line is intended to stop the script if the browser (in headful mode) is closed by user (while debugging)
  // browser.on( 'targetdestroyed', target => ( target.type() === 'other' ) ? close() : null );
  // for some reason it randomly stops the script after about ~30 screenshots processed

  /* Prepare injections */

  let cleanPage, injection, model;
  try {
    cleanPage = await fs.readFile(Relative.fullPath("clean-page.js"), "utf8");
    injection = await fs.readFile(Relative.fullPath("deterministic-injection.js"), "utf8");
    model = await fs.readFile(pathToIn3dModel);
  } catch (e) {
    console.red(e);
    close();
  }

  /* Prepare page */

  const errorMessagesCache = [];
  const pages = await browser.pages();
  if (pages.length === 0) pages.push(await browser.newPage());
  const page = pages[0];
  await preparePage(page, injection, model, errorMessagesCache);

  /* Make attempt */
  await makeAttempt(page, cleanPage, pathToOutPreview);

  /* Finish */

  setTimeout(close, 300, 0);
}

async function preparePage(page, injection, model, errorMessages) {
  await page.evaluateOnNewDocument(injection);
  await page.setRequestInterception(true);

  page.on("console", async (msg) => {
    const type = msg.type();

    if (type !== "warning" && type !== "error") {
      return;
    }

    const file = page.file;

    if (file === undefined) {
      return;
    }

    const args = await Promise.all(
      msg.args().map(async (arg) => {
        try {
          return await arg.executionContext().evaluate((arg) => (arg instanceof Error ? arg.message : arg), arg);
        } catch (e) {
          // Execution context might have been already destroyed
          return arg;
        }
      })
    );

    let text = args.join(" "); // https://github.com/puppeteer/puppeteer/issues/3397#issuecomment-434970058

    text = text.trim();
    if (text === "") return;

    text = file + ": " + text.replace(/\[\.WebGL-(.+?)\] /g, "");

    if (text === `${file}: JSHandle@error`) {
      text = `${file}: Unknown error`;
    }

    if (text.includes("Unable to access the camera/webcam")) {
      return;
    }

    if (errorMessages.includes(text)) {
      return;
    }

    errorMessages.push(text);

    if (type === "warning") {
      console.yellow(text);
    } else {
      page.error = text;
    }
  });

  page.on("response", async (response) => {
    try {
      if (response.status() === 200) {
        console.green(`Response: ${response.url()}, ${response.headers()["content-length"]} bytes`);
        await response.buffer().then((buffer) => (page.pageSize += buffer.length));
      } else if (response.status() === 302) {
        console.green(`Response: ${response.url()} (${response.status()})`);
      } else {
        console.red(`Response: ${response.url()} (${response.status()})`);
      }
    } catch {}
  });

  page.on("request", async (request) => {
    if (request.url() === `http://localhost:${port}/models/model.glb`) {
      const buffer = await Buffer.from(model);
      const fileType = await FileType.fileTypeFromBuffer(buffer);

      if (buffer.length > redirectToModelSize) {
        // save model as file with random name
        tempModelFileName = `model.${crypto.randomUUID()}.${fileType.ext}`;
        await fs.writeFile(`public/models/${tempModelFileName}`, buffer);

        console.green(`Model redirecting: ${tempModelFileName}`);
        // redirect request to the file
        await request.respond({
          status: 302,
          headers: {
            location: `/models/${tempModelFileName}`,
          },
        });

        // delete file after it was sent
        await page.waitForNetworkIdle({
          timeout: networkTimeout * 60000,
          idleTime: idleTime * 1000,
        });

        await fs.unlink(`public/models/${tempModelFileName}`);
        tempModelFileName = undefined;
      } else {
        console.green(`Model sending: ${fileType.ext}: ${fileType.mime} ${buffer.length} bytes`);
        await request.respond({
          status: 200,
          contentType: fileType.mime,
          body: buffer,
        });
      }
    } else {
      await request.continue();
    }
  });
}

async function makeAttempt(page, cleanPage, screenshotPath) {
  try {
    page.pageSize = 0;
    page.error = undefined;

    /* Load target page */
    const file = "index";

    try {
      await page.goto(`http://localhost:${port}/${file}.html`, {
        waitUntil: "networkidle0",
        timeout: networkTimeout * 60000,
      });
    } catch (e) {
      throw new Error(`Error happened while loading file ${file}: ${e}`);
    }

    try {
      /* Render page */
      console.green(`Rendering file ${file}`);
      await page.evaluate(cleanPage);

      await page.waitForNetworkIdle({
        timeout: networkTimeout * 60000,
        idleTime: idleTime * 1000,
      });

      await page.evaluate(
        async (renderTimeout, parseTime) => {
          await new Promise((resolve) => setTimeout(resolve, parseTime));

          /* Resolve render promise */

          window._renderStarted = true;

          await new Promise(function (resolve, reject) {
            const renderStart = performance._now();

            const waitingLoop = setInterval(function () {
              const renderTimeoutExceeded =
                renderTimeout > 0 && performance._now() - renderStart > 1000 * renderTimeout;

              if (renderTimeoutExceeded) {
                clearInterval(waitingLoop);
                reject("Render timeout exceeded");
              } else if (window._renderFinished) {
                clearInterval(waitingLoop);
                resolve();
              }
            }, 10);
          });
        },
        renderTimeout,
        (page.pageSize / 1024 / 1024) * parseTime * 1000
      );
    } catch (e) {
      if (e.includes && e.includes("Render timeout exceeded") === false) {
        throw new Error(`Error happened while rendering file ${file}: ${e}`);
      } /* else { // This can mean that the example doesn't use requestAnimationFrame loop

				console.yellow( `Render timeout exceeded in file ${ file }` );

			} */ // TODO: fix this
    }

    const screenshot = await page.screenshot({ omitBackground: true });

    if (page.error !== undefined) throw new Error(page.error);

    // check if image is only transparent
    const image = await sharp(screenshot).ensureAlpha().raw().toBuffer();
    const transparent = image.every((value, index) => index % 4 === 3 || value === 0);
    if (transparent) throw new Error("Image is transparent");

    /* Make screenshots */
    // downscale png screenshot
    const png = await sharp(screenshot).png().toBuffer();
    const downscale = await sharp(png).resize(width, height).toBuffer();
    await fs.writeFile(screenshotPath, downscale);

    console.green(`Screenshot generated for file ${screenshotPath}`);
  } catch (e) {
    console.red(e);
  }
}

function close(exitCode = 1) {
  console.log("Closing...");

  if (browser) browser.close();
  if (server) server.close();
  if (tempModelFileName) fs.unlink(`public/models/${tempModelFileName}`);

  process.exit(exitCode);
}

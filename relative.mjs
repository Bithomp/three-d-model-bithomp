import path from "path";

function fullRootPath(root, p) {
  return path.join(root, p);
}

function fullPath(p) {
  const dirname = rootPath();
  return fullRootPath(dirname, p);
}

function rootPath() {
  let root = null;

  try {
    // TODO: check if we still need this
    root = process.mainModule.paths[0].split("node_modules")[0].slice(0, -1);
  } catch (e) {
    root = process.cwd();
  }

  return root;
}

export { fullPath, fullRootPath, rootPath };

# imgset 
Basic Node app for bulk image resize and optimisaton for the web.

### Requirements
- Works with Node 18+ (tested on Node 20).
- Uses sharp under the hood.


### Install (local dev via symlink)
```bash
npm install 
chmod +x index.mjs 
npm link
```
This creates a global imgset command that points at your local folder.

### Commands
```bash
imgset init  -c config.json   # create a config with sensible defaults
imgset build -c config.json   # resize only
imgset html  -c config.json   # generate preview HTML only
imgset all   -c config.json   # resize + generate HTML
```

### Generate config
```bash
imgset init  -c config.json   # create a config with sensible defaults
```
If config.json lives in /project/tools/, then "./input" means /project/tools/input, regardless of where you run the command.

### Configure input and output folders
```bash
  "inputDir": "./input",
  "outputDir": "./output",
```

### Configure which file types to process
```bash 
"extensions": [
    "jpg",
    "jpeg",
    "png",
    "webp",
    "avif"
  ],
```

### Configure output formats 
```bash
"formats": [
    {
      "format": "avif",
      "quality": 32,
      "effort": 4
    },
    {
      "format": "webp",
      "quality": 80
    },
    {
      "format": "jpeg",
      "quality": 75,
      "progressive": true,
      "mozjpeg": true
    }
  ],
```

- AVIF: quality ~30–40 is typical; effort 4–6 balances speed/size.
- WebP: quality ~70–82.
- JPEG: quality ~72–85; progressive: true.

### Configure output sizes

```bash
   "sizes": [
        320,
        640,
        960,
        1280,
        1920,
        2560,
        3840
  ],
```
Leave the array empty (e.g. `"sizes": []`) to keep each image at its original width. You can also include an empty entry like `""` alongside other numbers to generate both the original size and the specified resized versions. When the original width is preserved, the tool keeps the original filename (only the extension changes to match the output format).
### Configure preview html file

```bash
"html": {
    "file": "index.html",
    "pageTitle": "Resized Images",
    "sizesAttribute": "100vw",
    "wrapFigure": true,
    "altFromFilename": true,
    "className": ""
  }
```

### Preserve subfolders
```bash
preserveFolders:true
```

### Uninstall
If you used npm link:
```bash
npm unlink -g imgset     # remove the global symlink
npm unlink               # (from project dir) remove local link
```

If you installed globally with npm i -g:

```bash
npm uninstall -g imgset
```

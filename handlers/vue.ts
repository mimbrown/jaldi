import { parse, compileScript, SFCDescriptor, compileStyle, compileTemplate } from "https://cdn.skypack.dev/@vue/compiler-sfc@^3.2.21?dts";
import { FileDescriptor } from "./types.ts";

export function makeVueHandler() {
  const cache: Record<string, SFCDescriptor | undefined> = {};
  const nextId = (() => {
    let id = 0;
    return () => (id++).toString();
  })();

  return async (file: FileDescriptor, url: URL) => {
    const { searchParams } = url;
    if (searchParams.has('vue')) {
      const descriptor = cache[file.path];
      if (!descriptor) {
        throw new Error('jaldi does not currently support manually importing `vue` blocks.');
      }

      const id = searchParams.get('id');
      if (!id) {
        throw new Error('Missing required parameter `id`.');
      }
      const type = searchParams.get('type');
      switch (type) {
        case 'script': {
          const compiledScript = compileScript(descriptor, { id });
          return compiledScript.content;
        }
        case 'style': {
          const styleBlock = descriptor.styles[parseInt(searchParams.get('index') ?? '', 10)];
          if (!styleBlock) {
            throw new Error('Unable to find referenced style block.');
          }
          const compiledStyle = compileStyle({
            id,
            filename: file.path,
            source: styleBlock.content,
          });
          return `const styleSheet = document.createElement('style')\n`
            + `styleSheet.innerText = \`${compiledStyle.code}\`\n`
            + `document.head.append(styleSheet)`;
        }
        case 'template': {
          const compiledTemplate = compileTemplate({
            id,
            filename: file.path,
            source: descriptor.template?.content ?? '',
          });
          return compiledTemplate.code;
        }
        default: {
          throw new Error('When importing `.vue` files, the `type` search param must be one of: script, template, style.');
        }
      }
    }
    const { descriptor } = parse(await file.contents(), {
      filename: file.path,
    });
    cache[file.path] = descriptor;
    const id = nextId();
    const code: string[] = [];
    if (descriptor.script || descriptor.scriptSetup) {
      code.push(`import script from '${url.pathname}?vue&type=script&id=${id}'`);
    } else {
      code.push('const script = {}');
    }
    if (descriptor.template) {
      code.push(
        `import { render } from '${url.pathname}?vue&type=template&id=${id}'`,
        'script.render = render',
      );
    }
    code.push(
      ...descriptor.styles.map((_, index) =>
        `import '${url.pathname}?vue&type=style&index=${index}&id=${id}'`,
      ),
    );
    code.push('export default script');
    return code.join('\n');
  }
}

/*
// main script
import script from '/project/foo.vue?vue&type=script'
// template compiled to render function
import { render } from '/project/foo.vue?vue&type=template&id=xxxxxx'
// css
import '/project/foo.vue?vue&type=style&index=0&id=xxxxxx'

// attach render function to script
script.render = render

// attach additional metadata
// some of these should be dev only
script.__file = 'example.vue'
script.__scopeId = 'xxxxxx'

// additional tooling-specific HMR handling code
// using __VUE_HMR_API__ global

export default script
 */

// console.log(await vueHandler(Deno.args[0]));

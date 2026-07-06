import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide53Tokens = contentTokens["slide-53"];

export function buildSlide53(presentation, tokens = slide53Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-53", width: "fill", height: "fill" }, [
      text([tokens.title.paragraph01, tokens.title.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "145px", width: "351px", height: "484px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title2.paragraph02, tokens.title2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-1",
        ...frame({ left: "453px", top: "145px", width: "351px", height: "484px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.title3.paragraph03, tokens.title3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-2",
        ...frame({ left: "864px", top: "145px", width: "352px", height: "484px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

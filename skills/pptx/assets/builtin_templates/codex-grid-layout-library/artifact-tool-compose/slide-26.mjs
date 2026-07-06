import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide26Tokens = contentTokens["slide-26"];

export function buildSlide26(presentation, tokens = slide26Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-26", width: "fill", height: "fill" }, [
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing2, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing3], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "195px", width: "581px", height: "435px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "37px", width: "581px", height: "55px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing2, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing3], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "658px", top: "230px", width: "581px", height: "399px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

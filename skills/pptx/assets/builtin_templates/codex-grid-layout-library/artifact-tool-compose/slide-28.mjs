import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide28Tokens = contentTokens["slide-28"];

export function buildSlide28(presentation, tokens = slide28Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-28", width: "fill", height: "fill" }, [
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing2], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "146px", width: "581px", height: "483px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "object-3",
        geometry: "rect",
        fill: "#EDEDED",
        ...frame({ left: "658px", top: "41px", width: "582px", height: "589px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

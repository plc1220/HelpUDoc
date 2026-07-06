import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide66Tokens = contentTokens["slide-66"];

export function buildSlide66(presentation, tokens = slide66Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-66", width: "fill", height: "fill" }, [
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "421px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-1",
        ...frame({ left: "453px", top: "421px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-2",
        ...frame({ left: "864px", top: "421px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-3",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "147px", width: "375px", height: "244px" }),
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "453px", top: "147px", width: "375px", height: "244px" }),
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "864px", top: "147px", width: "375px", height: "244px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

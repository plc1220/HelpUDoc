import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide48Tokens = contentTokens["slide-48"];

export function buildSlide48(presentation, tokens = slide48Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-48", width: "fill", height: "fill" }, [
      shape({
        name: "object-3",
        geometry: "rect",
        fill: "#EDEDED",
        ...frame({ left: "538px", top: "0px", width: "742px", height: "720px" }),
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "583px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.body2.titleGoesHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "196px", width: "578px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body1.titleGoesHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "41px", width: "578px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3.titleGoesHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "350px", width: "578px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body4.titleGoesHere, tokens.body4.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "661px", top: "504px", width: "578px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-303-p29",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "600px", top: "42px", width: "24px", height: "27px" }),
      }),
      shape({
        name: "Google-Shape-303-p29",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "600px", top: "199px", width: "24px", height: "27px" }),
      }),
      shape({
        name: "Google-Shape-303-p29",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "600px", top: "354px", width: "24px", height: "27px" }),
      }),
      shape({
        name: "Google-Shape-303-p29",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "600px", top: "509px", width: "24px", height: "27px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

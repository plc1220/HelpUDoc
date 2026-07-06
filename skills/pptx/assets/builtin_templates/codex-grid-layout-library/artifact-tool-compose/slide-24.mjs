import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide24Tokens = contentTokens["slide-24"];

export function buildSlide24(presentation, tokens = slide24Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-24", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "992px", height: "385px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-9",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "452px", top: "353px", width: "375px", height: "276px" }),
      }),
      shape({
        name: "Rounded-Rectangle-10",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "864px", top: "353px", width: "375px", height: "276px" }),
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-9",
        ...frame({ left: "485px", top: "435px", width: "310px", height: "150px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "896px", top: "435px", width: "310px", height: "150px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "486px", top: "388px", width: "25px", height: "25px" }),
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "896px", top: "388px", width: "25px", height: "25px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

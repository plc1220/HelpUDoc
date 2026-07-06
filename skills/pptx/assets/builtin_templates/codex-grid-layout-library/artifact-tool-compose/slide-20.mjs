import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide20Tokens = contentTokens["slide-20"];

export function buildSlide20(presentation, tokens = slide20Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-20", width: "fill", height: "fill" }, [
      shape({
        name: "Rounded-Rectangle-9",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "0px", top: "389px", width: "1280px", height: "331px" }),
      }),
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
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "452px", top: "507px", width: "375px", height: "123px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Text-Placeholder-16",
        ...frame({ left: "864px", top: "507px", width: "375px", height: "123px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "452px", top: "457px", width: "27px", height: "27px" }),
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "863px", top: "457px", width: "27px", height: "27px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

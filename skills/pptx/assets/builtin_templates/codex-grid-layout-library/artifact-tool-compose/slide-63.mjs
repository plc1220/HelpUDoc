import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide63Tokens = contentTokens["slide-63"];

export function buildSlide63(presentation, tokens = slide63Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-63", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-3",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-10",
        ...frame({ left: "41px", top: "36px", width: "581px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-36",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "658px", top: "353px", width: "271px", height: "279px" }),
      }),
      text([tokens.stat1], {
        name: "Content-Placeholder-9",
        ...frame({ left: "683px", top: "376px", width: "224px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.body2], {
        name: "Content-Placeholder-15",
        ...frame({ left: "690px", top: "532px", width: "217px", height: "65px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-39",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "968px", top: "353px", width: "271px", height: "279px" }),
      }),
      text([tokens.stat2], {
        name: "Content-Placeholder-9",
        ...frame({ left: "993px", top: "376px", width: "224px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.body3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "1000px", top: "532px", width: "217px", height: "65px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body1], {
        name: "Content-Placeholder-2",
        ...frame({ left: "657px", top: "205px", width: "582px", height: "104px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

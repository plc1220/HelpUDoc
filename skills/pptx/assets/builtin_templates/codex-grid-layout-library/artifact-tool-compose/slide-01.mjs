import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide01Tokens = contentTokens["slide-01"];

export function buildSlide01(presentation, tokens = slide01Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-01", width: "fill", height: "fill" }, [
      text([tokens.title4], {
        name: "Title-3",
        ...frame({ left: "41px", top: "183px", width: "992px", height: "262px" }),
        style: textStyles.helveticaNeueFont80BottomColorTx1,
      }),
      text([tokens.title5.loremIpsumDetails, tokens.title5.loremIpsumDetails2, tokens.title5.loremIpsumDetails3], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "503px", width: "375px", height: "128px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "41px", width: "169px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title2], {
        name: "Subtitle-4",
        ...frame({ left: "247px", top: "41px", width: "169px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title3], {
        name: "Subtitle-4",
        ...frame({ left: "863px", top: "41px", width: "376px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

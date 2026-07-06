import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide05Tokens = contentTokens["slide-05"];

export function buildSlide05(presentation, tokens = slide05Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-05", width: "fill", height: "fill" }, [
      image({
        name: "Picture-6",
        prompt: "dominant hero visual matching this template's visual system; subject or semantic cue: Picture 6; palette cues: tx1; image treatment: crop left 0%, top 15.849%, right 4.023%, bottom 15.849%; no embedded text, preserve generous crop room for slide overlays",
        alt: "hero placeholder for Picture 6",
        fit: "cover",
        crop: {"left":0,"top":0.15849,"right":0.04023,"bottom":0.15849},
        ...frame({ left: "774px", top: "0px", width: "506px", height: "720px" }),
      }),
      text([tokens.title2], {
        name: "Title-3",
        ...frame({ left: "41px", top: "183px", width: "616px", height: "262px" }),
        style: textStyles.helveticaNeueFont80BottomColorTx1,
      }),
      text([tokens.title3.loremIpsumDetails, tokens.title3.loremIpsumDetails2], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "561px", width: "375px", height: "69px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "41px", width: "376px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

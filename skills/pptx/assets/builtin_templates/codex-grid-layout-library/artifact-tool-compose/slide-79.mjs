import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide79Tokens = contentTokens["slide-79"];

export function buildSlide79(presentation, tokens = slide79Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-79", width: "fill", height: "fill" }, [
      text([tokens.body1], {
        name: "Google-Shape-558-p61",
        ...frame({ left: "41px", top: "421px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-556-p61",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.body2], {
        name: "Google-Shape-559-p61",
        ...frame({ left: "453px", top: "421px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([tokens.body3], {
        name: "Google-Shape-560-p61",
        ...frame({ left: "864px", top: "421px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-557-p61",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Google-Shape-561-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "449px", top: "360px", width: "33px", height: "37px" }),
      }),
      shape({
        name: "Google-Shape-562-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "35px", top: "360px", width: "34px", height: "38px" }),
      }),
      shape({
        name: "Google-Shape-563-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "862px", top: "365px", width: "36px", height: "28px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

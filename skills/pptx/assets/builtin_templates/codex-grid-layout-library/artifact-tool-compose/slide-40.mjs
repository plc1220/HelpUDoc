import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide40Tokens = contentTokens["slide-40"];

export function buildSlide40(presentation, tokens = slide40Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-40", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "823px", height: "61px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-1",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "42px", top: "318px", width: "581px", height: "139px" }),
      }),
      text([tokens.body2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "73px", top: "344px", width: "524px", height: "92px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body4.detailGoesHere, tokens.body4.detailGoesHere2, tokens.body4.detailGoesHere3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "73px", top: "474px", width: "550px", height: "103px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-7",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "657px", top: "318px", width: "581px", height: "139px" }),
      }),
      text([tokens.body3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "689px", top: "344px", width: "524px", height: "92px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.body5.detailGoesHere, tokens.body5.detailGoesHere2, tokens.body5.detailGoesHere3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "689px", top: "474px", width: "550px", height: "103px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([tokens.body1.topic, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing2], {
        name: "Content-Placeholder-15",
        ...frame({ left: "42px", top: "122px", width: "1197px", height: "171px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([tokens.body6], {
        name: "Content-Placeholder-15",
        ...frame({ left: "42px", top: "590px", width: "1197px", height: "56px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

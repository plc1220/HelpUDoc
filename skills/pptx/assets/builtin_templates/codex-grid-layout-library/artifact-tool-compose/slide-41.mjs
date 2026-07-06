import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide41Tokens = contentTokens["slide-41"];

export function buildSlide41(presentation, tokens = slide41Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-41", width: "fill", height: "fill" }, [
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
      text([tokens.body1.topic, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "42px", top: "122px", width: "1197px", height: "106px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      table({
        name: "Table-4",
        rows: 8,
        columns: 10,
        values: [["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"],["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"],["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"],["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"],["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"],["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"],["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"],["Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail","Detail"]],
        columnWidths: [374.45,91.43,91.43,91.43,91.43,91.43,91.43,91.43,91.43,91.43],
        ...frame({ left: "42px", top: "249px", width: "1197px", height: "380px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}

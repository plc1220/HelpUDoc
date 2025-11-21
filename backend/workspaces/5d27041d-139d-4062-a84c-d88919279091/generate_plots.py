
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

# Load the dataset
try:
    df = pd.read_csv('holistic_health_lifestyle_dataset.csv')
except FileNotFoundError:
    print("Error: holistic_health_lifestyle_dataset.csv not found.")
    exit()

# Identify numerical columns for histograms
numerical_cols = df.select_dtypes(include=['number']).columns

print(f"Numerical columns found: {list(numerical_cols)}")

# Generate and save histograms for numerical columns
for col in numerical_cols:
    plt.figure(figsize=(10, 6))
    sns.histplot(df[col].dropna(), kde=True)
    plt.title(f'Histogram of {col}')
    plt.xlabel(col)
    plt.ylabel('Frequency')
    plt.savefig(f'{col}_histogram.png')
    plt.close()
    print(f"Saved histogram for {col} as {col}_histogram.png")

# Generate and save a bar plot for 'Health_Status'
if 'Health_Status' in df.columns:
    plt.figure(figsize=(10, 6))
    sns.countplot(data=df, x='Health_Status', palette='viridis')
    plt.title('Bar Plot of Health Status')
    plt.xlabel('Health Status')
    plt.ylabel('Count')
    plt.savefig('Health_Status_bar_plot.png')
    plt.close()
    print("Saved bar plot for Health_Status as Health_Status_bar_plot.png")
else:
    print("Error: 'Health_Status' column not found in the dataset.")

print("Plot generation complete.")
